#!/bin/sh
set -e

cd /app/packages/backend

# 上传目录子结构（绑定挂载到宿主机空目录时需重建：audio/video/bgm + Finder 打开请求队列）
mkdir -p uploads/audio uploads/video uploads/bgm uploads/.open-requests

echo "[entrypoint] waiting for MySQL..."
node -e '
const net = require("node:net");
const host = process.env.DB_HOST || "mysql";
const port = Number(process.env.DB_PORT || 3306);
const tryConnect = () => {
  const sock = net.connect(port, host);
  sock.on("connect", () => {
    console.log("[entrypoint] MySQL ready");
    process.exit(0);
  });
  sock.on("error", () => setTimeout(tryConnect, 2000));
};
tryConnect();
'

echo "[entrypoint] running migrations..."
npx tsx src/db/migrate.ts

echo "[entrypoint] seeding word bank..."
npx tsx src/db/seed.ts

echo "[entrypoint] starting backend..."
exec npx tsx src/index.ts