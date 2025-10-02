/*import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message } from "../shared";

export class Chat extends Server<Env> {
  static options = { hibernate: true };

  messages = [] as ChatMessage[];

  broadcastMessage(message: Message, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  onStart() {
    // this is where you can initialize things that need to be done before the server starts
    // for example, load previous messages from a database or a service

    // create the messages table if it doesn't exist
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
    );

    // load the messages from the database
    this.messages = this.ctx.storage.sql
      .exec(`SELECT * FROM messages`)
      .toArray() as ChatMessage[];
  }

  onConnect(connection: Connection) {
    connection.send(
      JSON.stringify({
        type: "all",
        messages: this.messages,
      } satisfies Message),
    );
  }

  saveMessage(message: ChatMessage) {
    // check if the message already exists
    const existingMessage = this.messages.find((m) => m.id === message.id);
    if (existingMessage) {
      this.messages = this.messages.map((m) => {
        if (m.id === message.id) {
          return message;
        }
        return m;
      });
    } else {
      this.messages.push(message);
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO messages (id, user, role, content) VALUES ('${
        message.id
      }', '${message.user}', '${message.role}', ${JSON.stringify(
        message.content,
      )}) ON CONFLICT (id) DO UPDATE SET content = ${JSON.stringify(
        message.content,
      )}`,
    );
  }

  onMessage(connection: Connection, message: WSMessage) {
    // let's broadcast the raw message to everyone else
    this.broadcast(message);

    // let's update our local messages store
    const parsed = JSON.parse(message as string) as Message;
    if (parsed.type === "add" || parsed.type === "update") {
      this.saveMessage(parsed);
    }
  }
}

export default {
  async fetch(request, env) {
    return (
      (await routePartykitRequest(request, { ...env })) ||
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
*/
// chat.ts (PartyKit / Cloudflare Workers 用の Chat サーバー例)
// 仮定:
// - this.ctx.storage.sql.prepare(...).bind(...).run()/all() が利用可能（Cloudflare D1準拠）
// - env.OPENAI_API_KEY / env.OPENAI_API_URL / env.OPENAI_MODEL は任意（なければローカルルール応答へフォールバック）

import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message } from "../shared";

const BOT_SYSTEM_PROMPT = `
BSP.txt :[
営業時間: 9時～18時です
担当者: 総務部です
]

BSP.txtについて今から私は話します。なのでBSP.txtに対応する回答を返してください
`.trim();

export class Chat extends Server<Env> {
  static options = { hibernate: true };

  messages: ChatMessage[] = [];

  // broadcast 用ユーティリティ（常に JSON.stringify）
  broadcastMessage(message: Message, exclude?: string[]) {
    const payload = JSON.stringify(message);
    this.broadcast(payload, exclude);
  }

  // DB 初期化（存在しない場合はテーブル作成）
  async initDb() {
    try {
      // できれば prepare を使って安全に実行する
      if (typeof this.ctx.storage.sql.prepare === "function") {
        this.ctx.storage.sql
          .prepare(
            `CREATE TABLE IF NOT EXISTS messages (
               id TEXT PRIMARY KEY,
               user TEXT,
               role TEXT,
               content TEXT
             )`,
          )
          .run();
      } else {
        // 最低限のフォールバック（ただし環境により安全性は低下）
        this.ctx.storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
        );
      }
    } catch (e) {
      // 初期化失敗してもアプリは続けたい：ログを残す
      console.error("initDb error:", e);
    }
  }

  // DB からメッセージ読み込み（複数の返り値形に耐える）
  async loadMessagesFromDb() {
    let rows: any[] = [];
    try {
      if (typeof this.ctx.storage.sql.prepare === "function") {
        const stmt = this.ctx.storage.sql.prepare(`SELECT * FROM messages`);
        // prefer .all()
        if (typeof stmt.all === "function") {
          rows = stmt.all();
        } else {
          // まれに run() が結果を持つ場合
          const r = stmt.run();
          rows = (r && r.results) || [];
        }
      } else if (typeof this.ctx.storage.sql.exec === "function") {
        const r = this.ctx.storage.sql.exec(`SELECT * FROM messages`);
        if (!r) rows = [];
        else if (Array.isArray(r)) rows = r;
        else if (typeof r.toArray === "function") rows = r.toArray();
        else rows = r.results || [];
      }
    } catch (e) {
      console.error("loadMessagesFromDb error:", e);
      rows = [];
    }

    // content は JSON 文字列で保存してる想定 -> パース
    this.messages = rows.map((row) => {
      let content = row.content;
      try {
        if (typeof content === "string") content = JSON.parse(content);
      } catch {
        // パース失敗したらそのまま
      }
      return {
        id: String(row.id),
        user: String(row.user),
        role: String(row.role),
        content,
      } as ChatMessage;
    });
  }

  // メッセージ保存（プレースホルダで安全に）
  saveMessageToDb(message: ChatMessage) {
    const jsonContent = JSON.stringify(message.content);

    try {
      if (typeof this.ctx.storage.sql.prepare === "function") {
        // SQLite 的な ON CONFLICT を使う。Cloudflare D1 で動く想定。
        this.ctx.storage.sql
          .prepare(
            `INSERT INTO messages (id, user, role, content)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               user = excluded.user,
               role = excluded.role,
               content = excluded.content`,
          )
          .bind(message.id, message.user, message.role, jsonContent)
          .run();
      } else {
        // 非推奨フォールバック（環境によっては脆弱）
        // ここはなるべく使わないで、prepare が存在する環境で動かしてください
        this.ctx.storage.sql.exec(
          `INSERT INTO messages (id, user, role, content)
           VALUES ('${message.id}', '${message.user}', '${message.role}', '${jsonContent}')
           ON CONFLICT(id) DO UPDATE SET content='${jsonContent}'`,
        );
      }
    } catch (e) {
      console.error("saveMessageToDb error:", e);
    }

    // メモリ側も更新
    const idx = this.messages.findIndex((m) => m.id === message.id);
    if (idx >= 0) this.messages[idx] = message;
    else this.messages.push(message);
  }

  // シンプルなローカルルールレスポンダ（AI が無いか失敗したときのフォールバック）
  localRuleResponder(userText: string): string {
    const t = userText.toLowerCase();
    if (t.includes("営業時間")) return "9時～18時です";
    if (t.includes("担当者") || t.includes("担当")) return "担当は総務部です";
    return "確認しますので少々お待ちください";
  }

  // AI 呼び出しの例（OpenAI Chat Completions 互換を想定）
  // env.OPENAI_API_KEY / env.OPENAI_API_URL / env.OPENAI_MODEL を使う想定
  async callAiIfAvailable(env: Env, userText: string): Promise<string> {
    // 必要な環境変数が無ければローカルルールを使う
    if (!env.OPENAI_API_KEY || !env.OPENAI_API_URL) {
      return this.localRuleResponder(userText);
    }

    try {
      const body = {
        model: env.OPENAI_MODEL ?? "gpt-4o-mini", // 任意
        messages: [
          { role: "system", content: BOT_SYSTEM_PROMPT },
          { role: "user", content: userText },
        ],
        temperature: 0.0,
        max_tokens: 400,
      };

      const res = await fetch(env.OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        console.error("AI call failed:", await res.text());
        return this.localRuleResponder(userText);
      }

      const data = await res.json();
      // OpenAI 形式の応答を想定
      const aiText =
        data?.choices?.[0]?.message?.content ??
        data?.output?.[0]?.content ??
        null;
      if (aiText) return String(aiText).trim();
      return this.localRuleResponder(userText);
    } catch (e) {
      console.error("callAiIfAvailable error:", e);
      return this.localRuleResponder(userText);
    }
  }

  // ここから Server ライフサイクル
  async onStart() {
    await this.initDb();
    await this.loadMessagesFromDb();

    // 最初の案内メッセージを必ず出す（system prompt のルールに沿って）
    const hasHello = this.messages.some(
      (m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("こんにちは"),
    );
    if (!hasHello) {
      const hello: ChatMessage = {
        id: `sys-hello-${Date.now()}`,
        user: "system",
        role: "assistant",
        content: "こんにちは。ご質問があればどうぞ。",
      };
      this.saveMessageToDb(hello);
    }
  }

  onConnect(connection: Connection) {
    const payload: Message = {
      type: "all",
      messages: this.messages,
    };
    connection.send(JSON.stringify(payload));
  }

  // message を受けたらブロードキャスト & DB 反映。もしユーザーからの問い合わせなら AI に投げる（オプション）
  async onMessage(connection: Connection, raw: WSMessage) {
    // raw は文字列のはずなので parse
    let parsed: Message;
    try {
      parsed = JSON.parse(raw as string) as Message;
    } catch (e) {
      console.error("invalid ws message:", e);
      return;
    }

    // 受信したものをそのまま他へ配信（統一して文字列化）
    this.broadcastMessage(parsed);

    // add / update は DB に保存
    if (parsed.type === "add" || parsed.type === "update") {
      // Message を ChatMessage として扱うための型キャスト注意
      const cm = parsed as unknown as ChatMessage;
      this.saveMessageToDb(cm);
    }

    // ユーザーがチャットに「問い合わせ（user_query のような独自 type）」を送ってきたら AI で返す例
    // フロント側で type: "user_query", content: "営業時間は？" のように投げる運用を想定
    if (parsed.type === "user_query" && typeof parsed.content === "string") {
      const userText = parsed.content as string;
      const aiReply = await this.callAiIfAvailable(this.env, userText);

      const botMessage: ChatMessage = {
        id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        user: "bot",
        role: "assistant",
        content: aiReply,
      };

      // persist + broadcast
      this.saveMessageToDb(botMessage);
      this.broadcastMessage({ type: "add", message: botMessage } as unknown as Message);
    }
  }
}

// Worker fetch handler
export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routePartykitRequest(request, { ...env })) ||
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;

