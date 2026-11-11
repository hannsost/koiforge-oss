export { moduleSchema } from './schema.js';
export {
  collectDeclaredContracts,
  formatValidationErrors,
  parseContractReference,
  parseManifestText,
  validateManifestDocument,
  validateManifestText,
} from './validator.js';
export type {
  ActionContribution,
  ExtensionContribution,
  ManifestValidationIssue,
  ManifestValidationResult,
  MigrationDefinition,
  ModuleManifest,
  ObjectContribution,
  PolicyContribution,
  PropertyDefinition,
  PropertyType,
  TrustLevel,
  UiContribution,
} from './types.js';

