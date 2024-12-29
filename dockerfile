FROM node:20.10.0

RUN apt-get update && apt-get install -y redis-server

WORKDIR /usr/src/app

COPY package.json .
RUN npm install

COPY . .

EXPOSE 6379
EXPOSE ${PORT}

CMD ["sh", "-c", "redis-server --daemonize yes && node index.js"]
