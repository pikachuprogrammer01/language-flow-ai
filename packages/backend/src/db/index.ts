import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { logger } from "../lib/logger";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const connection = await mysql.createConnection(databaseUrl);

export const db = drizzle(connection);

logger.info("Database connected");
