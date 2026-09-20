/**
 * API 错误信封（DX-1）：稳定、可解析的结构化错误体。
 * 形状 { error: { code, message, field?, received?, allowed?, hint? } }
 * - 4xx 校验类：附 field / received / allowed / hint，供前端上屏"问题+原因+修复"
 * - 5xx 内部错误：message 用固定文案，绝不透传底层 err.message（避免泄漏内部信息）
 */
export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    field?: string;
    received?: string;
    allowed?: string[];
    hint?: string;
  };
}

export function apiError(
  code: string,
  message: string,
  extra?: Omit<ApiErrorPayload["error"], "code" | "message">,
): ApiErrorPayload {
  return { error: { code, message, ...extra } };
}

/** 500 服务器内部错误（不泄漏内部信息，细节由调用方 logger.error 落日志） */
export function internalError(): ApiErrorPayload {
  return apiError("INTERNAL", "服务器内部错误，请稍后重试");
}
