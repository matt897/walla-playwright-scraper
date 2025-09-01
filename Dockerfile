# You can bump PLAYWRIGHT_TAG and PLAYWRIGHT_VERSION when needed
ARG PLAYWRIGHT_TAG=1.55.0-jammy
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_TAG}

# Keep the npm package in lockstep with the image’s browser bundle
ARG PLAYWRIGHT_VERSION=1.55.0

WORKDIR /app
COPY server.js /app/server.js

# Install only what we need, pinning playwright to the matching version
RUN npm init -y >/dev/null 2>&1 \
 && npm pkg set type=module >/dev/null 2>&1 \
 && npm install --omit=dev express@4 cors@2 playwright@${PLAYWRIGHT_VERSION}

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
