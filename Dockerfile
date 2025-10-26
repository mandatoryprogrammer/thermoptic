FROM node:20

RUN mkdir /work/
WORKDIR /work/

RUN mkdir /work/ssl/
COPY package.json /work/
COPY package-lock.json /work/
RUN npm install
RUN npm install --prefix /work/anyproxy commander
COPY ./anyproxy /work/anyproxy/
RUN sed -i 's/\r$//' /work/anyproxy/bin/anyproxy-ca
RUN /work/anyproxy/bin/anyproxy-ca --generate
RUN cp /root/.anyproxy/certificates/rootCA.crt /work/ssl/
RUN cp /root/.anyproxy/certificates/rootCA.key /work/ssl/

COPY cdp.js /work/
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

COPY docker-entrypoint.sh /work/
RUN chmod +x /work/docker-entrypoint.sh
RUN sed -i 's/\r$//' /work/docker-entrypoint.sh

ENTRYPOINT ["/work/docker-entrypoint.sh"]
