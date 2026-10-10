// The OpenCode TUI supplies these modules to plugins at runtime. Only the
// universal-renderer calls this package uses are declared, so the build does
// not need OpenTUI's native packages installed.

declare module "@opentui/solid" {
  export namespace JSX {
    type Element = unknown
  }
  export type Node = object
  export function createElement(tag: string): Node
  export function createTextNode(value: string): Node
  export function insertNode(parent: Node, node: Node, anchor?: Node): void
  export function insert(
    parent: Node,
    accessor: unknown,
    marker?: Node | null,
  ): unknown
  export function setProp<T>(node: Node, name: string, value: T, prev?: T): T
  export function effect<T>(fn: (prev?: T) => T, init?: T): void
}

declare module "solid-js" {
  export function createMemo<T>(fn: () => T): () => T
  export function createComponent<P>(
    component: (props: P) => unknown,
    props: P,
  ): unknown
  export function Show<T>(props: {
    when: T | undefined | null | false
    children: unknown
  }): unknown
}
