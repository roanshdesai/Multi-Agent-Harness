import { mkdirSync, readdirSync, statSync, existsSync, renameSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runCodex } from "../codex.js";
import { codexStatus } from "../subscription.js";

const unavailable = (detail: string) => ({ isError: true, content: [{ type: "text" as const, text: `GPT unavailable: ${detail}` }] });

/** Ask a GPT model (ChatGPT subscription, via Codex). Read-only: it can look at files but not change them. */
export function askGptTool(root: string, models: string[]) {
  return tool(
    "ask_gpt",
    `Ask a GPT model through the user's ChatGPT subscription. Use it when the user asks for GPT, for a second opinion from another model family, or when a subagent is configured to run on GPT. Available models: ${models.join(", ")}. It can read files in the working folder but cannot change them.`,
    {
      prompt: z.string().describe("Full, self-contained instructions; GPT does not see this conversation"),
      model: z.string().optional().describe(`Default ${models[0]}`),
    },
    async ({ prompt, model }) => {
      const s = codexStatus(root);
      if (!s.ok) return unavailable(s.detail);
      const r = await runCodex({ root, model: model ?? models[0], prompt, cwd: process.cwd(), sandbox: "read-only", ephemeral: true }).done;
      if (!r.ok) return { isError: true, content: [{ type: "text" as const, text: `GPT failed: ${r.error}` }] };
      return { content: [{ type: "text" as const, text: r.text || "(no answer)" }] };
    },
  );
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function newestImage(dir: string, since: number): string | null {
  let best: { p: string; t: number } | null = null;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!IMAGE_EXT.has(extname(f).toLowerCase())) continue;
    const t = statSync(p).mtimeMs;
    if (t >= since && (!best || t > best.t)) best = { p, t };
  }
  return best?.p ?? null;
}

/** Images: generate, edit, or describe, on the image model set in harness.config.yaml. */
export function imageTool(root: string, model: string, fallback: string) {
  return tool(
    "image",
    `Create, edit or analyze images with ${model} (falls back to ${fallback}) through the user's ChatGPT subscription. Use for ANY image work: generating images, mockups, icons, illustrations, editing an existing image, or describing/reviewing screenshots. Saves generated images under out/images/ and returns their paths.`,
    {
      task: z.enum(["generate", "edit", "analyze"]),
      prompt: z.string().describe("What to create or change, or what to look for"),
      images: z.array(z.string()).optional().describe("Input image paths (required for edit and analyze)"),
      filename: z.string().optional().describe("Output file name for generate/edit, e.g. hero.png"),
    },
    async ({ task, prompt, images, filename }) => {
      const s = codexStatus(root);
      if (!s.ok) return unavailable(s.detail);
      const inputs = (images ?? []).map((p) => resolve(p));
      const missing = inputs.filter((p) => !existsSync(p));
      if (missing.length) return { isError: true, content: [{ type: "text" as const, text: `Missing image(s): ${missing.join(", ")}` }] };
      if (task !== "generate" && !inputs.length) return { isError: true, content: [{ type: "text" as const, text: `${task} needs at least one input image.` }] };

      const outDir = join(process.cwd(), "out", "images");
      mkdirSync(outDir, { recursive: true });
      const target = join(outDir, filename ?? `image-${Date.now()}.png`);
      const instructions =
        task === "analyze"
          ? `Look at the attached image(s) and answer precisely:\n${prompt}`
          : `${task === "edit" ? "Edit the attached image" : "Generate an image"} using your image generation tool.\n${prompt}\n\nSave the final image as ${target}. Reply with the saved path and one sentence describing it.`;

      const started = Date.now();
      let r = await runCodex({ root, model, prompt: instructions, cwd: outDir, images: inputs, ephemeral: true, sandbox: task === "analyze" ? "read-only" : "workspace-write" }).done;
      if (!r.ok && fallback && fallback !== model) {
        r = await runCodex({ root, model: fallback, prompt: instructions, cwd: outDir, images: inputs, ephemeral: true, sandbox: task === "analyze" ? "read-only" : "workspace-write" }).done;
      }
      if (!r.ok) return { isError: true, content: [{ type: "text" as const, text: `Image ${task} failed: ${r.error}` }] };
      if (task === "analyze") return { content: [{ type: "text" as const, text: r.text }] };

      // Codex may save under its own name; make sure the requested path exists.
      if (!existsSync(target)) {
        const made = newestImage(outDir, started);
        if (made) renameSync(made, target);
      }
      if (!existsSync(target)) return { isError: true, content: [{ type: "text" as const, text: `No image file was produced.\n${r.text}` }] };
      return { content: [{ type: "text" as const, text: `Saved ${target}\n${r.text}` }] };
    },
  );
}
