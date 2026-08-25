/**
 * 数据库连接与 Drizzle 实例的唯一创建入口。
 *
 * 进程内复用 pg 连接池，供 API、Dashboard 与 Workflow job 共享。
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

let pool: Pool | null = null;

/** 延迟创建并返回进程级 pg 连接池，避免模块加载时就要求数据库配置。 */
export function getDatabasePool() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required to initialize the database connection.");
  }

  pool ??= new Pool({
    connectionString,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });

  return pool;
}

export function getDatabase() {
  return drizzle(getDatabasePool(), { schema });
}

export type Database = ReturnType<typeof getDatabase>;
