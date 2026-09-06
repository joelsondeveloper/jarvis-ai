export type Message = {
  id?: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};