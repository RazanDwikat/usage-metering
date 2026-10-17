FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
# the client remembers its companies' API keys here (a volume in docker-compose.yml)
RUN mkdir /data && chown node:node /data
ENV DATA_FILE=/data/companies.json
USER node
EXPOSE 8080
CMD ["node", "server.js"]
