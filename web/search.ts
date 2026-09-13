// Quick search: `/` or Ctrl+K, type a sha prefix / file path / commit
// subject, Enter or click to jump to the node in the scene.

import { el } from "./scene.ts";
import type { RepoModel } from "./api.ts";

export interface SearchHit {
  kind: "commit" | "file" | "object" | "ref";
  label: string;
  detail?: string;
  pick: () => void; // jump (and optionally inspect)
}

export function searchModel(model: RepoModel, query: string, limit = 8): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];

  for (const c of model.commits) {
    if (hits.length >= limit) break;
    if (c.sha.startsWith(q) || c.subject.toLowerCase().includes(q)) {
      hits.push({ kind: "commit", label: c.subject || "(no message)", detail: c.sha.slice(0, 7), pick: () => jumpToElement(`.commit-row[data-sha="${c.sha}"]`) });
    }
  }
  for (const r of model.refs) {
    if (hits.length >= limit) break;
    if (r.short.toLowerCase().includes(q)) {
      const target = r.kind === "tag" ? r.peeled ?? r.sha : r.sha;
      hits.push({ kind: "ref", label: r.short, detail: r.kind, pick: () => jumpToElement(`.commit-row[data-sha="${target}"]`) });
    }
  }
  for (const e of model.index.entries) {
    if (hits.length >= limit) break;
    if (e.path.toLowerCase().includes(q)) {
      hits.push({ kind: "file", label: e.path, detail: "index", pick: () => jumpToChip(e.path) });
    }
  }
  for (const u of model.status.untracked) {
    if (hits.length >= limit) break;
    if (u.toLowerCase().includes(q)) {
      hits.push({ kind: "file", label: u, detail: "worktree", pick: () => jumpToChip(`worktree/${u}`) });
    }
  }
  for (const o of model.objects) {
    if (hits.length >= limit) break;
    if (o.sha.startsWith(q) && q.length >= 4) {
      hits.push({ kind: "object", label: o.sha.slice(0, 12), detail: `${o.type} · ${o.where.kind}`, pick: () => jumpToElement(`.obj-card[data-sha="${o.sha}"]`) });
    }
  }
  return hits;
}

function jumpToElement(selector: string): void {
  const node = document.querySelector<HTMLElement>(selector);
  if (node) window.dispatchEvent(new CustomEvent("gitv:jump", { detail: { node } }));
}

function jumpToChip(key: string): void {
  const chip = [...document.querySelectorAll<HTMLElement>(".chip")].find((c) => c.dataset.key === key);
  if (chip) window.dispatchEvent(new CustomEvent("gitv:jump", { detail: { node: chip } }));
}

export function renderHits(container: HTMLElement, hits: SearchHit[], onPick: (h: SearchHit) => void): void {
  container.replaceChildren();
  for (const h of hits) {
    const row = el("div", `hit hit-${h.kind}`);
    const dot = el("span", "hit-dot");
    row.append(dot, el("span", "hit-label", h.label));
    if (h.detail) row.append(el("span", "hit-detail", h.detail));
    row.addEventListener("click", () => onPick(h));
    container.appendChild(row);
  }
}
