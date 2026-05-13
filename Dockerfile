# Base image
FROM node:20-alpine

# Install some utilities (optional but good for debugging/Prisma)
RUN apk add --no-cache openssl gcompat

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm install

# Generate Prisma Client
RUN npx prisma generate

# Copy source code
COPY . .

# Expose port
EXPOSE 8080

# Environment variables (default)
ENV NODE_ENV=production
ENV PORT=8080

# Command to run the application
CMD ["npm", "start"]
