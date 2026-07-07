FROM node:22-slim
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @zhixing/db exec prisma generate
EXPOSE 8787
CMD ["sh", "-c", "pnpm --filter @zhixing/db exec prisma migrate deploy && pnpm --filter @zhixing/api exec tsx src/server.ts"]
