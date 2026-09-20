/**
 * Three.js 片头 vendor 构建期拷贝脚本（决策 D3：npm 依赖 + 构建期拷贝）
 *
 * 溯源：three@0.160.0（pnpm-lock.yaml 记录精确 integrity），来源 https://www.npmjs.com/package/three
 * 产物：packages/backend/src/renderer/vendor/ 下两个文件已被 .gitignore 忽略，不入库。
 * 运行：pnpm --filter @ai-english/backend copy:vendor（本地 dev 由 scripts/stack.sh 调用；Docker 由构建阶段调用）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** three examples/jsm 文件随包不带许可头，拷贝时补回标准 MIT 头（与 three.module.min.js 一致） */
const THREE_LICENSE_HEADER = `/**
 * @license
 * Copyright 2010-2023 Three.js Authors
 * SPDX-License-Identifier: MIT
 */
`;

function resolveThreeRoot(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDir, "../node_modules/three");
  try {
    readFileSync(resolve(root, "package.json"));
  } catch {
    throw new Error(
      `找不到 three 包（${root}）。原因：依赖未安装或版本缺失。修复：在仓库根执行 pnpm install。`,
    );
  }
  return root;
}

function copyRaw(sourceFile: string, targetFile: string): number {
  const bytes = readFileSync(sourceFile);
  writeFileSync(targetFile, bytes);
  return bytes.byteLength;
}

function copyWithLicenseHeader(sourceFile: string, targetFile: string): number {
  const body = readFileSync(sourceFile, "utf8");
  const withHeader = body.startsWith("/**") ? body : `${THREE_LICENSE_HEADER}${body}`;
  writeFileSync(targetFile, withHeader, "utf8");
  return Buffer.byteLength(withHeader, "utf8");
}

function main(): void {
  const threeRoot = resolveThreeRoot();
  const vendorDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer/vendor");
  mkdirSync(vendorDir, { recursive: true });

  const minSize = copyRaw(
    resolve(threeRoot, "build/three.module.min.js"),
    resolve(vendorDir, "three.module.min.js"),
  );
  const cssSize = copyWithLicenseHeader(
    resolve(threeRoot, "examples/jsm/renderers/CSS2DRenderer.js"),
    resolve(vendorDir, "CSS2DRenderer.js"),
  );
  console.log(
    `[copy:vendor] three.module.min.js ${minSize}B · CSS2DRenderer.js ${cssSize}B → ${vendorDir}`,
  );
}

main();
