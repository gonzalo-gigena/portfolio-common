# One image definition for every Node fake. Each compose file passes its own server.js as build context.
FROM node:26.13-bookworm-slim
WORKDIR /app
COPY server.js ./
USER node
CMD ["node", "server.js"]
