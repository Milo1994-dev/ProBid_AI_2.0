import { db } from "../../db.js";
import { conversations, chatMessages } from "../../../shared/schema.js";
import { eq, desc, and } from "drizzle-orm";

export interface IChatStorage {
  getConversation(id: number, userId: string): Promise<typeof conversations.$inferSelect | undefined>;
  getAllConversations(userId: string): Promise<(typeof conversations.$inferSelect)[]>;
  createConversation(title: string, userId: string): Promise<typeof conversations.$inferSelect>;
  deleteConversation(id: number, userId: string): Promise<void>;
  getMessagesByConversation(conversationId: number): Promise<(typeof chatMessages.$inferSelect)[]>;
  createMessage(conversationId: number, role: string, content: string): Promise<typeof chatMessages.$inferSelect>;
}

export const chatStorage: IChatStorage = {
  async getConversation(id: number, userId: string) {
    const [conversation] = await db.select().from(conversations).where(
      and(eq(conversations.id, id), eq(conversations.userId, userId))
    );
    return conversation;
  },

  async getAllConversations(userId: string) {
    return db.select().from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.createdAt));
  },

  async createConversation(title: string, userId: string) {
    const [conversation] = await db.insert(conversations).values({ title, userId }).returning();
    return conversation;
  },

  async deleteConversation(id: number, userId: string) {
    const [conv] = await db.select().from(conversations).where(
      and(eq(conversations.id, id), eq(conversations.userId, userId))
    );
    if (conv) {
      await db.delete(chatMessages).where(eq(chatMessages.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
  },

  async getMessagesByConversation(conversationId: number) {
    return db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId)).orderBy(chatMessages.createdAt);
  },

  async createMessage(conversationId: number, role: string, content: string) {
    const [message] = await db.insert(chatMessages).values({ conversationId, role, content }).returning();
    return message;
  },
};

