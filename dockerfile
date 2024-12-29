FROM node:20.10.0

RUN apt-get update && apt-get install -y git redis-server

WORKDIR /usr/src/app

RUN git clone https://github.com/shikhasoumya1612/url-shortner .

RUN npm install

EXPOSE 6379
EXPOSE ${PORT}

CMD ["sh", "-c", "redis-server --daemonize yes && node index.js"]
