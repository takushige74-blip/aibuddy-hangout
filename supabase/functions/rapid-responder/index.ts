import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

interface ReqPayload {
  message: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

export default {
  fetch: withSupabase(
    { auth: "user" },
    async (req: Request, context: any) => {
      let stage = "開始";

      try {
        if (req.method !== "POST") {
          return jsonResponse(
            { error: "POSTで送信してください。" },
            405
          );
        }

        stage = "ログイン確認";

        const { data: userData, error: userError } =
          await context.supabase.auth.getUser();

        if (userError || !userData.user) {
          throw new Error("ログインユーザーを確認できませんでした。");
        }

        const user = userData.user;

        stage = "メッセージ取得";

        const payload: ReqPayload = await req.json();

        if (
          typeof payload.message !== "string" ||
          payload.message.trim().length === 0 ||
          payload.message.length > 4000
        ) {
          return jsonResponse(
            { error: "メッセージの内容を確認してください。" },
            400
          );
        }

        stage = "所属部屋の確認";

        const { data: membership, error: membershipError } =
          await context.supabase
            .from("room_members")
            .select("room_id")
            .eq("user_id", user.id)
            .maybeSingle();

        if (membershipError) {
          throw new Error(membershipError.message);
        }

        if (!membership) {
          throw new Error("所属する部屋が見つかりません。");
        }

        const roomId = membership.room_id;

        stage = "相棒の確認";

        const roomSettings: Record<
          string,
          { companionName: string; instructions: string }
        > = {
          "shige-haru": {
            companionName: "ハル",
            instructions:
              "あなたはハルです。シゲの相棒として、日本語で自然に会話してください。親しみやすく、気取らず、必要なら軽い冗談も交えてください。",
          },
          "yoshi-kata": {
            companionName: "カタ",
            instructions:
              "あなたはカタです。よっしーの相棒として、日本語で自然に会話してください。親しみやすく、気取らず、必要なら軽い冗談も交えてください。",
          },
        };

        const roomSetting = roomSettings[roomId];

        if (!roomSetting) {
          throw new Error("対応していない部屋です。");
        }

        const companionName = roomSetting.companionName;
        const companionInstructions = roomSetting.instructions;

        stage = "APIキー確認";

        const apiKey = Deno.env.get("OPENAI_API_KEY");

        if (!apiKey) {
          throw new Error("OPENAI_API_KEYが設定されていません。");
        }

        stage = "OpenAI接続";

        const aiResponse = await fetch(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: "gpt-6-luna",
              instructions: companionInstructions,
              input: payload.message,
              max_output_tokens: 500,
            }),
          }
        );

        stage = "OpenAI応答の読み取り";

        const responseText = await aiResponse.text();
        const result = JSON.parse(responseText);

        if (!aiResponse.ok) {
          throw new Error(
            result.error?.message ?? "OpenAI APIエラー"
          );
        }

        stage = "返事の取り出し";

        const reply = (result.output ?? [])
          .flatMap(
            (item: { content?: Array<{ type: string; text?: string }> }) =>
              item.content ?? []
          )
          .filter(
            (part: { type: string }) => part.type === "output_text"
          )
          .map(
            (part: { text?: string }) => part.text ?? ""
          )
          .join("\n");

        if (!reply) {
          throw new Error("AIから返事を受け取れませんでした。");
        }

        stage = "Supabase保存";

        const { error: saveError } = await context.supabase
          .from("messages")
          .insert({
            content: reply,
            sender: companionName,
            room_id: roomId,
            user_id: user.id,
          });

        if (saveError) {
          throw new Error(saveError.message);
        }

        console.log("処理成功");

        return jsonResponse({ reply });

      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        console.error("処理失敗:", stage, message);

        return jsonResponse(
          {
            error: "処理に失敗しました。",
            stage,
            detail: message,
          },
          500
        );
      }
    }
  ),
};