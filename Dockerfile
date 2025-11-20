FROM node:20

RUN mkdir /work/
WORKDIR /work/

RUN mkdir /work/ssl/
COPY package.json /work/
COPY package-lock.json /work/
RUN npm install

COPY cdp.js /work/
COPY certificates.js /work/
COPY config.js /work/
COPY fetchgen.js /work/
COPY healthcheck.js /work/
COPY server.js /work/
COPY proxy.js /work/
COPY requestengine.js /work/
COPY routes.js /work/
COPY utils.js /work/
COPY wait-for-cdp.js /work/
COPY logger.js /work/
COPY scripts /work/scripts/

COPY docker-entrypoint.sh /work/
RUN chmod +x /work/docker-entrypoint.sh
RUN sed -i 's/\r$//' /work/docker-entrypoint.sh

ENTRYPOINT ["/work/docker-entrypoint.sh"]
