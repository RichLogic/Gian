export class PluginStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginStoreError';
  }
}

export class PluginVersionConflictError extends PluginStoreError {
  constructor(pluginId: string, pluginVersion: string) {
    super(
      'PLUGIN_VERSION_CONFLICT',
      `Immutable package ${pluginId}@${pluginVersion} already exists with different content.`,
    );
    this.name = 'PluginVersionConflictError';
  }
}

export class PluginReferencedError extends PluginStoreError {
  constructor(pluginId: string, pluginVersion: string) {
    super(
      'PLUGIN_VERSION_REFERENCED',
      `${pluginId}@${pluginVersion} is referenced by current, a Session binding, or an in-flight operation.`,
    );
    this.name = 'PluginReferencedError';
  }
}
