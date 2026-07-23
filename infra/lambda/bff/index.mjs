const blockedRequestHeaders = new Set(["connection", "content-length", "host", "transfer-encoding"]);
const blockedResponseHeaders = new Set(["connection", "content-length", "transfer-encoding"]);
const baseUrl = process.env.PROFILE_GO_BASE_URL;

export const handler = async (event) => {
  if (!baseUrl) {
    return jsonResponse(500, { error: "PROFILE_GO_BASE_URL is not configured" });
  }

  const method = event.requestContext?.http?.method ?? "GET";
  const rawPath = event.rawPath ?? "/";
  const rawQuery = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const targetUrl = `${baseUrl}${rawPath}${rawQuery}`;
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).filter(([name]) => !blockedRequestHeaders.has(name.toLowerCase())),
  );

  try {
    const response = await fetch(targetUrl, {
      body: method === "GET" || method === "HEAD" ? undefined : decodeRequestBody(event),
      headers,
      method,
      signal: AbortSignal.timeout(12_000),
    });
    const responseHeaders = Object.fromEntries(
      [...response.headers.entries()].filter(([name]) => !blockedResponseHeaders.has(name.toLowerCase())),
    );
    // 标记当前代码或环境变化后发布出的 Lambda Version，便于验证灰度流量。
    responseHeaders["x-bff-release"] = process.env.BFF_RELEASE ?? "unknown";
    responseHeaders["x-bff-function-version"] = process.env.AWS_LAMBDA_FUNCTION_VERSION ?? "$LATEST";

    return {
      body: await response.text(),
      headers: responseHeaders,
      isBase64Encoded: false,
      statusCode: response.status,
    };
  } catch (error) {
    console.error("private ALB request failed", {
      message: error instanceof Error ? error.message : "unknown error",
      path: rawPath,
    });
    return jsonResponse(502, { error: "Go API is unavailable" });
  }
};

const decodeRequestBody = (event) => {
  if (!event.body) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
};

const jsonResponse = (statusCode, body) => ({
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json; charset=utf-8",
    "x-bff-release": process.env.BFF_RELEASE ?? "unknown",
    "x-bff-function-version": process.env.AWS_LAMBDA_FUNCTION_VERSION ?? "$LATEST",
  },
  isBase64Encoded: false,
  statusCode,
});
