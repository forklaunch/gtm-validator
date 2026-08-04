FROM node:23-alpine

# Set working directory
WORKDIR /gtm-validator

# Copy source code
COPY . .

# Install dependencies
RUN npm install -g pnpm@10
RUN apk update
RUN apk add --no-cache libc6-compat
RUN apk add --no-cache git
RUN apk add --no-cache curl

# Trust the AWS RDS certificate authorities so TLS connections to RDS
# (PGSSLMODE=require / DB_SSL=true) don't fail as self-signed
RUN curl -sSfo /etc/ssl/certs/aws-rds-global-bundle.pem \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    && chmod 644 /etc/ssl/certs/aws-rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global-bundle.pem

RUN pnpm install

# Build TypeScript code

RUN pnpm build