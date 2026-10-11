import { Schema } from "effect"

const Author = Schema.Union([
    Schema.String,
    Schema.Struct({ name: Schema.String }),
  ]),
  Location = Schema.Struct({
    directory: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(Schema.String),
    url: Schema.optionalKey(Schema.String),
  }),
  Names = Schema.Record(Schema.String, Schema.String),
  PackageJson = Schema.Struct({
    author: Schema.optionalKey(Author),
    dependencies: Schema.optionalKey(Names),
    devDependencies: Schema.optionalKey(Names),
    engines: Schema.optionalKey(Names),
    exports: Schema.optionalKey(Names),
    files: Schema.optionalKey(Schema.Array(Schema.String)),
    keywords: Schema.optionalKey(Schema.Array(Schema.String)),
    license: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    optionalDependencies: Schema.optionalKey(Names),
    peerDependencies: Schema.optionalKey(Names),
    private: Schema.optionalKey(Schema.Boolean),
    repository: Schema.optionalKey(Location),
    scripts: Schema.optionalKey(Names),
    type: Schema.optionalKey(Schema.String),
    version: Schema.optionalKey(Schema.String),
  }),
  /** The `package.json` fields the layout check reads, from its JSON text. */
  PackageManifest = Schema.fromJsonString(PackageJson)

export default PackageManifest
