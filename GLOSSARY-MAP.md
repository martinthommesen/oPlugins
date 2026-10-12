# Glossary map

## Contexts

- [oc-plugins](./docs/GLOSSARY.md): terms shared by every plugin
- [oc-advisor](./packages/oc-advisor/GLOSSARY.md): letting an agent ask a second
  model for a second opinion
- [oc-auth](./packages/oc-auth/GLOSSARY.md): sending Anthropic model requests
  with the user's Claude Code subscription credentials
- [oc-auto](./packages/oc-auto/GLOSSARY.md): having a reviewer model judge
  permission prompts before they reach the user
- [oc-browser](./packages/oc-browser/GLOSSARY.md): letting an OpenCode agent
  work in the user's own Chrome profile

## Relationships

- **oc-plugins → every plugin**: each plugin uses the shared terms, such as
  **host**, **option**, **root session**, and **transcript**, and defines only
  its own.
- **oc-advisor and oc-auto**: both write a **transcript** for another model, the
  **advisor** or the **reviewer**, but each decides on its own what the
  transcript holds and how it's shortened.
- **oc-plugins → oc-browser**: oc-browser's **native host** is a program of its
  own, never the shared **host**, so oc-browser always names it in full. In
  oc-browser, "extension" means its Chrome extension, one part of the plugin,
  never the plugin itself.
