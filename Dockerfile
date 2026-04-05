# --- Frontend (Vite + React) → web/static ---
FROM node:20-alpine AS ui-build
WORKDIR /repo/web/ui
COPY web/ui/package.json web/ui/package-lock.json ./
RUN npm ci
COPY web/ui/ ./
RUN npm run build

# --- Python app ---
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
COPY --from=ui-build /repo/web/static /app/web/static

EXPOSE 8000
CMD ["python", "main.py", "--host", "0.0.0.0"]
