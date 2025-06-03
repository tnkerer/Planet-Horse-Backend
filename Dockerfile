# Stage 1: Build the NestJS app
FROM node:20 AS builder

WORKDIR /usr/src/app

# Copy package.json + package-lock.json (if any)
COPY package*.json ./

# Install deps
RUN npm install --production=false

# Copy everything else & compile
COPY . .
RUN npm run build

# Stage 2: Prepare the runtime image
FROM node:20

WORKDIR /usr/src/app

# Only copy needed files from builder
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Expose the port (we’ll default to 8080)
ENV PORT=8080

# Run the built NestJS app
CMD ["node", "dist/main"]
