import { Icon } from "~/components/icon";

/**
 * A bundle manifest is a flat list of paths with slashes in them. Rendered as
 * a list, a skill with eight files under `scripts/` is eight lines that all
 * start the same way; rendered as a tree it is one line you can read past.
 */

export type TreeFile = {
  path: string;
  size: number;
  /** Empty for a registry preview, which has no per-file digest to show. */
  sha256: string;
};

type Node = {
  name: string;
  file: TreeFile | null;
  children: Node[];
};

export function FileTree({
  files,
  root,
}: {
  files: TreeFile[];
  /** The SKILL.md itself, which is not in the bundle manifest. */
  root?: TreeFile;
}) {
  const nodes = build(root ? [root, ...files] : files);
  return (
    <ul className="file-tree">
      {nodes.map((node) => (
        <Branch key={node.name} node={node} />
      ))}
    </ul>
  );
}

function Branch({ node }: { node: Node }) {
  if (node.file !== null) {
    return (
      <li className="file">
        <Icon name="file" />
        <span>{node.name}</span>
        <small>
          {bytes(node.file.size)}
          {node.file.sha256 ? ` · ${node.file.sha256.slice(0, 12)}` : ""}
        </small>
      </li>
    );
  }
  return (
    <li className="folder">
      <Icon name="folderOpen" />
      <span>{node.name}</span>
      <small>{plural(count(node))}</small>
      <ul>
        {node.children.map((child) => (
          <Branch key={child.name} node={child} />
        ))}
      </ul>
    </li>
  );
}

/** Folders before files, each group alphabetical, which is how a tree reads. */
function build(files: TreeFile[]): Node[] {
  const roots: Node[] = [];
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let level = roots;
    segments.forEach((segment, index) => {
      const leaf = index === segments.length - 1;
      let node = level.find(
        (candidate) =>
          candidate.name === segment && (candidate.file === null) !== leaf,
      );
      if (node === undefined) {
        node = { name: segment, file: leaf ? file : null, children: [] };
        level.push(node);
      }
      level = node.children;
    });
  }
  return sort(roots);
}

function sort(nodes: Node[]): Node[] {
  for (const node of nodes) sort(node.children);
  nodes.sort((a, b) => {
    if ((a.file === null) !== (b.file === null))
      return a.file === null ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

function count(node: Node): number {
  return node.children.reduce(
    (total, child) => total + (child.file === null ? count(child) : 1),
    0,
  );
}

function plural(files: number): string {
  return `${files} ${files === 1 ? "file" : "files"}`;
}

function bytes(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
}
