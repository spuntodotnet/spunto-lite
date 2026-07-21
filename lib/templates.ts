// Starter templates ("instant-start"): each scaffolds a working app in /workspace
// via postCreate, then runs it via postStart. No repo cloning needed — reliable and
// self-contained. Maps directly onto the project spec.

export type Template = {
  id: string
  name: string
  description: string
  stack: string
  image: string
  features?: { id: string; options?: Record<string, string> }[]
  postCreateCommand: string
  postStartCommand: string
  forwardPorts: number[]
}

export const TEMPLATES: Template[] = [
  {
    id: "nextjs",
    name: "Next.js",
    description: "App Router, TypeScript, Tailwind — scaffolded with create-next-app.",
    stack: "Node.js",
    image: "mcr.microsoft.com/devcontainers/javascript-node:20",
    postCreateCommand:
      "npx --yes create-next-app@latest . --ts --eslint --app --tailwind --src-dir --import-alias '@/*' --use-npm --yes",
    postStartCommand: "npm run dev -- -p 3000",
    forwardPorts: [3000],
  },
  {
    id: "vite-react",
    name: "Vite + React",
    description: "Vite React + TypeScript dev server.",
    stack: "Node.js",
    image: "mcr.microsoft.com/devcontainers/javascript-node:20",
    postCreateCommand: "npm create vite@latest . -- --template react-ts && npm install",
    postStartCommand: "npm run dev -- --host --port 5173",
    forwardPorts: [5173],
  },
  {
    id: "astro",
    name: "Astro",
    description: "Astro content site, minimal starter.",
    stack: "Node.js",
    image: "mcr.microsoft.com/devcontainers/javascript-node:20",
    postCreateCommand: "npm create astro@latest . -- --template minimal --install --no-git --skip-houston --yes",
    postStartCommand: "npm run dev -- --host --port 4321",
    forwardPorts: [4321],
  },
  {
    id: "fastapi",
    name: "FastAPI",
    description: "Python FastAPI with hot-reload uvicorn.",
    stack: "Python",
    image: "mcr.microsoft.com/devcontainers/python:3.12",
    postCreateCommand:
      "pip install --user fastapi 'uvicorn[standard]' && printf 'from fastapi import FastAPI\\napp = FastAPI()\\n\\n@app.get(\"/\")\\ndef root():\\n    return {\"hello\": \"spunto\"}\\n' > main.py",
    postStartCommand: "python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload",
    forwardPorts: [8000],
  },
  {
    id: "express",
    name: "Express",
    description: "Minimal Node.js Express API.",
    stack: "Node.js",
    image: "mcr.microsoft.com/devcontainers/javascript-node:20",
    postCreateCommand:
      "npm init -y && npm install express && printf \"const e=require('express');const a=e();a.get('/',(_,r)=>r.json({hello:'spunto'}));a.listen(3000,()=>console.log('up:3000'))\" > index.js",
    postStartCommand: "node index.js",
    forwardPorts: [3000],
  },
  {
    id: "docker-compose",
    name: "Docker-in-Docker",
    description: "Ubuntu base with a working Docker daemon inside the worker.",
    stack: "Docker",
    image: "mcr.microsoft.com/devcontainers/base:ubuntu",
    features: [{ id: "docker-in-docker" }],
    postCreateCommand: "docker --version || true",
    postStartCommand: "echo 'Docker-in-Docker ready — try: docker run hello-world'",
    forwardPorts: [],
  },
]
