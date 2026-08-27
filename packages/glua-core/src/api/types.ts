export type Realm = 'client' | 'server' | 'shared' | 'menu';

export interface ApiParam {
  name: string;
  type: string;
  description?: string;
  default?: string;
  optional?: boolean;
  /** For function-typed parameters: the arguments the callback receives. */
  callback?: ApiParam[];
  /** For function-typed parameters: what the callback is expected to return. */
  callbackReturns?: ApiParam[];
}

export type ApiFunctionKind = 'func' | 'libraryfunc' | 'classfunc' | 'hook' | 'panelfunc';

export interface ApiOverload {
  params: ApiParam[];
  returns: ApiParam[];
  description?: string;
}

export interface ApiFunction {
  name: string;
  /** `Global`, a library name (`net`), or a class name (`Entity`). */
  parent: string;
  kind: ApiFunctionKind;
  realm: Realm;
  /** Wiki page address, e.g. `Entity:SetHealth`. */
  address: string;
  params: ApiParam[];
  returns: ApiParam[];
  /** Additional documented call forms, e.g. `surface.SetDrawColor(color)`. */
  overloads?: ApiOverload[];
  description?: string;
  deprecated?: string | true;
  internal?: boolean;
  removed?: boolean;
  example?: string;
}

export interface ApiEnumItem {
  key: string;
  value: string;
  description?: string;
}

export interface ApiEnum {
  name: string;
  address: string;
  realm: Realm;
  description?: string;
  items: ApiEnumItem[];
}

export interface ApiStruct {
  name: string;
  address: string;
  realm: Realm;
  description?: string;
  fields: ApiParam[];
}

export interface ApiData {
  generatedAt: string;
  source: string;
  globals: Record<string, ApiFunction>;
  libraries: Record<string, Record<string, ApiFunction>>;
  classes: Record<string, Record<string, ApiFunction>>;
  hooks: Record<string, Record<string, ApiFunction>>;
  panels: Record<string, Record<string, ApiFunction>>;
  enums: Record<string, ApiEnum>;
  structs: Record<string, ApiStruct>;
}
