/** This pure projection is also compiled into the pinned upstream CLI. Never
 * serialize a Provider config: it can contain API keys and request headers. */
interface Selection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string | undefined } | undefined;
}

interface RegistryView {
  readonly providers: readonly {
    readonly providerId: string;
    readonly providerName?: string | null | undefined;
    readonly models: readonly {
      readonly modelId: string;
      readonly config: {
        readonly enabled: boolean;
        readonly properties: {
          readonly contextWindow: number;
          readonly inputFormat: { readonly supportsImage: boolean; readonly supportsPdf: boolean; readonly supportsVideo: boolean };
        };
        readonly optionSpecs: {
          readonly reasoningLevel: { readonly values: readonly string[] };
          readonly maxOutputTokens: { readonly max: number };
        };
      };
    }[];
  }[];
  readonly preferredSelection?: Selection | undefined;
}

export function serializeModelCatalog(view: RegistryView) {
  const models = view.providers.flatMap(provider => provider.models.filter(model => model.config.enabled).map(model => {
    const values = model.config.optionSpecs.reasoningLevel.values;
    return {
      ref: { providerId: provider.providerId, modelId: model.modelId },
      label: model.modelId,
      providerLabel: provider.providerName ?? provider.providerId,
      contextWindow: model.config.properties.contextWindow,
      maxOutputTokens: model.config.optionSpecs.maxOutputTokens.max,
      supportsImages: model.config.properties.inputFormat.supportsImage,
      supportsPdf: model.config.properties.inputFormat.supportsPdf,
      supportsVideo: model.config.properties.inputFormat.supportsVideo,
      reasoning: { enabled: values.length > 0, levels: values.map(value => ({ value })), defaultLevel: values.at(-1) },
    };
  }));
  const selected = view.preferredSelection;
  return {
    schemaVersion: 1,
    models,
    ...(selected ? { selection: {
      providerId: selected.providerId, modelId: selected.modelId,
      ...(selected.options?.reasoningLevel ? { options: { reasoningLevel: selected.options.reasoningLevel } } : {}),
    } } : {}),
  };
}
