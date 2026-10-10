# Glossary Map

## Contexts

- [oc-plugins](./docs/GLOSSARY.md): terms shared by every plugin
- [oc-browser](./packages/oc-browser/GLOSSARY.md): letting an OpenCode agent
  work in the user's own Chrome profile

## Relationships

- **oc-plugins → oc-browser**: oc-browser uses the shared terms. Its
  **native host** is a program of its own, never the shared **host**, so
  oc-browser always names it in full.
