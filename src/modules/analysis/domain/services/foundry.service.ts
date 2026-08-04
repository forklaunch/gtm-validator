import { OpenTelemetryCollector } from '@forklaunch/core/http';
import { Metrics } from '@gtm-validator/monitoring';

export class AiUnavailableError extends Error {}

/**
 * Thin Azure AI Foundry chat-completions client, shared by the analysis,
 * adversarial, refinement, and blueprint services. Configure with
 * FOUNDRY_ENDPOINT + FOUNDRY_API_KEY (+ FOUNDRY_MODEL). Without
 * configuration, callers receive isConfigured() === false and are expected
 * to degrade to clearly-labeled offline samples.
 */
export class FoundryService {
  constructor(
    private readonly openTelemetryCollector: OpenTelemetryCollector<Metrics>,
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly apiVersion: string
  ) {}

  isConfigured(): boolean {
    return Boolean(this.endpoint && this.apiKey);
  }

  /** Call the model and return raw text output. */
  complete = async (
    systemPrompt: string,
    userPrompt: string,
    maxCompletionTokens = 4000
  ): Promise<string> => {
    const url = this.resolveUrl();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': this.apiKey,
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          ...(this.model ? { model: this.model } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          // Reasoning-class models reject max_tokens/custom temperature and
          // spend from this budget on reasoning before any visible output
          max_completion_tokens: maxCompletionTokens
        })
      });
    } catch (error) {
      this.openTelemetryCollector.error(
        `[foundry] request failed: ${(error as Error).message}`
      );
      throw new AiUnavailableError('The AI service could not be reached');
    }
    if (!response.ok) {
      const detail = await response.text();
      this.openTelemetryCollector.error(
        `[foundry] ${response.status}: ${detail.slice(0, 300)}`
      );
      throw new AiUnavailableError('The AI service returned an error');
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new AiUnavailableError('The AI service returned an empty response');
    }
    return content;
  };

  /** Call the model and parse a JSON object out of its response. */
  completeJson = async <T>(
    systemPrompt: string,
    userPrompt: string,
    maxCompletionTokens = 4000
  ): Promise<T> => {
    const raw = await this.complete(systemPrompt, userPrompt, maxCompletionTokens);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new AiUnavailableError('The AI service returned unparseable output');
    }
    try {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    } catch {
      throw new AiUnavailableError('The AI service returned invalid JSON');
    }
  };

  private resolveUrl(): string {
    const endpoint = this.endpoint.replace(/\/+$/, '');
    if (endpoint.includes('/chat/completions')) return endpoint;
    if (endpoint.includes('services.ai.azure.com')) {
      return `${endpoint}/models/chat/completions?api-version=${this.apiVersion}`;
    }
    if (endpoint.includes('openai.azure.com')) {
      return `${endpoint}/openai/deployments/${this.model}/chat/completions?api-version=${this.apiVersion}`;
    }
    return `${endpoint}/chat/completions`;
  }
}
