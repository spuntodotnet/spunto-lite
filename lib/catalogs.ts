// Curated catalogs for the project spec form. Ported from Spunto's
// modules/images + modules/features, trimmed to the local use case.

export type DevImage = { id: string; label: string; image: string; description: string }

export const AVAILABLE_IMAGES: DevImage[] = [
  {
    id: "typescript-node-20",
    label: "Node.js 20 (TypeScript)",
    image: "mcr.microsoft.com/devcontainers/typescript-node:20",
    description: "Node.js 20 + TypeScript, npm/yarn/pnpm",
  },
  {
    id: "javascript-node-20",
    label: "Node.js 20 (JavaScript)",
    image: "mcr.microsoft.com/devcontainers/javascript-node:20",
    description: "Node.js 20, npm/yarn/pnpm",
  },
  {
    id: "python-312",
    label: "Python 3.12",
    image: "mcr.microsoft.com/devcontainers/python:3.12",
    description: "Python 3.12, pip, conda",
  },
  {
    id: "go-121",
    label: "Go 1.21",
    image: "mcr.microsoft.com/devcontainers/go:1.21",
    description: "Go 1.21, go tools",
  },
  { id: "rust", label: "Rust", image: "mcr.microsoft.com/devcontainers/rust:latest", description: "Rust stable, cargo" },
  {
    id: "java-21",
    label: "Java 21",
    image: "mcr.microsoft.com/devcontainers/java:21",
    description: "Java 21 (JDK), Maven, Gradle",
  },
  {
    id: "universal",
    label: "Universal (multi-language)",
    image: "mcr.microsoft.com/devcontainers/universal:2",
    description: "Node, Python, Go, Java, Ruby, PHP… (large)",
  },
  { id: "base-ubuntu", label: "Ubuntu (base)", image: "mcr.microsoft.com/devcontainers/base:ubuntu", description: "Plain Ubuntu, add features as needed" },
]

export type DevFeature = {
  id: string
  label: string
  ociRef?: string
  localScript?: string
  description: string
  options?: { name: string; default: string; description: string }[]
  defaultOptions?: Record<string, string>
}

export const AVAILABLE_FEATURES: DevFeature[] = [
  {
    id: "docker-in-docker",
    label: "Docker-in-Docker",
    ociRef: "ghcr.io/coderhammer/features/docker-in-docker:3",
    description: "Docker Engine inside the container (DinD)",
    options: [{ name: "version", default: "latest", description: "Docker/Moby Engine version" }],
    defaultOptions: { moby: "false" },
  },
  {
    id: "claude-code",
    label: "Claude Code",
    ociRef: "ghcr.io/stu-bell/devcontainer-features/claude-code:0",
    description: "Claude Code CLI inside the container",
  },
  {
    id: "node",
    label: "Node.js",
    ociRef: "ghcr.io/devcontainers/features/node:1",
    description: "Node.js, nvm, yarn, pnpm",
    options: [{ name: "version", default: "lts", description: "Node.js version (lts, 20, 22, etc.)" }],
  },
  {
    id: "python",
    label: "Python",
    ociRef: "ghcr.io/devcontainers/features/python:1",
    description: "Python, pip, venv",
    options: [{ name: "version", default: "latest", description: "Python version" }],
  },
  {
    id: "go",
    label: "Go",
    ociRef: "ghcr.io/devcontainers/features/go:1",
    description: "Go compiler and tools",
    options: [{ name: "version", default: "latest", description: "Go version" }],
  },
  {
    id: "rust",
    label: "Rust",
    ociRef: "ghcr.io/devcontainers/features/rust:1",
    description: "Rust, cargo, rustup",
    options: [{ name: "version", default: "latest", description: "Rust version" }],
  },
  { id: "aws-cli", label: "AWS CLI", ociRef: "ghcr.io/devcontainers/features/aws-cli:1", description: "AWS CLI v2" },
  { id: "github-cli", label: "GitHub CLI", ociRef: "ghcr.io/devcontainers/features/github-cli:1", description: "GitHub CLI (gh)" },
  {
    id: "terraform",
    label: "Terraform",
    ociRef: "ghcr.io/devcontainers/features/terraform:1",
    description: "HashiCorp Terraform CLI",
  },
  {
    id: "common-utils",
    label: "Common Utilities",
    ociRef: "ghcr.io/devcontainers/features/common-utils:2",
    description: "zsh, Oh My Zsh, git, curl, etc.",
  },
]

export type ExtensionSuggestion = { id: string; label: string }

export const SUGGESTED_EXTENSIONS: ExtensionSuggestion[] = [
  { id: "esbenp.prettier-vscode", label: "Prettier" },
  { id: "dbaeumer.vscode-eslint", label: "ESLint" },
  { id: "ms-python.python", label: "Python" },
  { id: "golang.go", label: "Go" },
  { id: "rust-lang.rust-analyzer", label: "rust-analyzer" },
  { id: "bradlc.vscode-tailwindcss", label: "Tailwind CSS IntelliSense" },
  { id: "eamodio.gitlens", label: "GitLens" },
  { id: "ms-azuretools.vscode-docker", label: "Docker" },
]
