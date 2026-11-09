FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com
COPY scripts ./scripts
COPY lib ./lib
# 容器对外监听必须带 token（入口脚本强制校验）；key 走环境变量注入，不入镜像
ENV WB_MCP_HTTP_HOST=0.0.0.0 WB_MCP_HTTP_PORT=3100
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/health || exit 1
CMD ["node", "scripts/wb-mcp-http.mjs"]
