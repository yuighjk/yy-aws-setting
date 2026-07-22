// Cloudflare Pages 浏览器请求现有 API Gateway；后端再经 Lambda BFF 进入私有 ALB。
// 本地开发时可临时改回 http://localhost:8080。
window.APP_CONFIG = {
  API_BASE_URL: "https://96r1jv57ee.execute-api.ap-northeast-1.amazonaws.com/yy-aws-setting",
};
