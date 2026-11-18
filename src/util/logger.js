const REDACTED = "[已隐藏]";

const SECRET_PATTERNS = [
  // accessToken / refreshToken / password / code 等出现在 JSON 或查询串中的情况
  /("(?:accessToken|refreshToken|password|passwd|code|dev_access_code|authorization)"\s*:\s*")[^"]*(")/gi,
  // Authorization: Bearer xxx
  /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  // auth-token=... 之类的 Cookie 片段
  /((?:auth-token|token|access_token|refresh_token|dev_access_code)\s*[=:]\s*)[^;,\s"']+/gi,
  // 设备接入码长度为 8 的十六进制串，只在明确上下文里出现
  /((?:access[_-]?code|lan[_-]?access[_-]?code)\s*[=:]\s*)[0-9a-f]{8}/gi,
];

/**
 * 去掉日志中的令牌、密码、验证码和设备接入码。
 *
 * 设计要求：令牌、密码、验证码、授权头和原始完整响应都不得写入日志。
 * 这里做的是最后一层兜底，业务层仍应只记录必要的字段。
 */
function redact(value, secrets = []) {
  let text;
  if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else if (typeof value === "string") {
    text = value;
  } else if (value === undefined) {
    text = "undefined";
  } else if (value === null) {
    text = "null";
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 3) continue;
    for (const candidate of [secret, encodeURIComponent(secret)]) {
      text = text.split(candidate).join(REDACTED);
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      const prefix = args[1] || "";
      // 两个捕获组的模式（JSON 字段）需要保留结尾引号；只有一组的模式
      // 第二个参数是 match offset，不能误当成 suffix 拼进结果。
      const suffix = args.length >= 5 ? args[2] || "" : "";
      return `${prefix}${REDACTED}${suffix}`;
    });
  }
  return text;
}

/**
 * 包装宿主 logger，统一脱敏，并对重复错误做节流。
 *
 * @param {object} logger SDK 提供的 logger（winston 实例）
 * @param {object} [options]
 * @param {number} [options.repeatIntervalMs] 相同错误文本的最小打印间隔
 * @param {() => number} [options.now]
 * @param {(entry: {level: string, message: string, at: number}) => void} [options.onRecord]
 *   脱敏并去重后的日志回调，供浏览器后台的诊断缓冲使用；不能影响主流程。
 */
function createSafeLogger(logger, { repeatIntervalMs = 60_000, now = () => Date.now(), onRecord } = {}) {
  const lastBySignature = new Map();

  function emit(level, message, secrets, signature) {
    const text = redact(message, secrets);
    const stamp = now();
    const previous = lastBySignature.get(signature);
    if (previous !== undefined && stamp - previous < repeatIntervalMs) return;
    lastBySignature.set(signature, stamp);
    if (lastBySignature.size > 200) {
      for (const [key, at] of lastBySignature) {
        if (stamp - at >= repeatIntervalMs) lastBySignature.delete(key);
      }
    }
    if (typeof onRecord === "function") {
      try {
        onRecord({ level, message: text, at: stamp });
      } catch {
        // 诊断回调失败不能影响日志和主流程。
      }
    }
    const target = logger && typeof logger[level] === "function" ? logger[level] : logger?.info;
    if (typeof target === "function") target.call(logger, text);
  }

  return {
    debug: (message, secrets) => emit("debug", message, secrets, `debug:${redact(message, secrets)}`),
    info: (message, secrets) => emit("info", message, secrets, `info:${redact(message, secrets)}`),
    warn: (message, secrets) => emit("warn", message, secrets, `warn:${redact(message, secrets)}`),
    error: (message, secrets) => emit("error", message, secrets, `error:${redact(message, secrets)}`),
    redact,
  };
}

module.exports = { REDACTED, redact, createSafeLogger };
