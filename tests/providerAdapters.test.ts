import { describe, expect, it, vi } from 'vitest';
import { YandexFoundationModelsAdapter } from '../src/lib/contentEnrichmentYandex.js';
import { YandexSpeechKitAdapter, parseYandexRecognitionEvents } from '../src/lib/speechToTextYandex.js';

describe('real provider adapters', () => {
  it('parses final SpeechKit events, applies normalized refinements and labels speakers', () => {
    expect(
      parseYandexRecognitionEvents([
        {
          audioCursors: { finalIndex: '0' },
          final: { channelTag: '0', alternatives: [{ text: 'сырой текст', startTimeMs: '0', endTimeMs: '1200' }] },
        },
        {
          finalRefinement: {
            finalIndex: '0',
            normalizedText: {
              channelTag: '0',
              alternatives: [{ text: 'Нормализованный текст.', startTimeMs: '0', endTimeMs: '1200' }],
            },
          },
        },
        {
          audioCursors: { finalIndex: '1' },
          final: { channelTag: '1', alternatives: [{ text: 'Ответ.', startTimeMs: '1200', endTimeMs: '2400' }] },
        },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 1200, speaker: 'Спикер 1', text: 'Нормализованный текст.' },
      { startMs: 1200, endMs: 2400, speaker: 'Спикер 2', text: 'Ответ.' },
    ]);
  });

  it('submits, polls, reads and deletes a SpeechKit async recognition without exposing storage credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'operation-1', done: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'operation-1', done: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          [
            JSON.stringify({
              audioCursors: { finalIndex: '0' },
              final: { alternatives: [{ text: 'Юридический термин.', startTimeMs: '0', endTimeMs: '1000' }] },
            }),
          ].join('\n'),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const adapter = new YandexSpeechKitAdapter(
      {
        apiKey: 'test-api-key-never-logged',
        folderId: 'folder-1',
        recognizeEndpoint: 'https://stt.example.test/stt/v3/recognizeFileAsync',
        operationEndpoint: 'https://stt.example.test/operations',
        resultEndpoint: 'https://stt.example.test/stt/v3/getRecognition',
        deleteEndpoint: 'https://stt.example.test/stt/v3/deleteRecognition',
        audioUriPrefix: 'https://storage.example.test/private-bucket/',
        model: 'general',
        pollIntervalMs: 500,
        timeoutSeconds: 60,
      },
      fetchMock,
      async () => undefined,
    );
    await expect(
      adapter.transcribe({
        storageKey: 'organizations/org-1/assets/a-1/renditions/v1/speech.ogg',
        language: 'ru-RU',
        durationSeconds: 1,
        dictionary: [{ term: 'АСПБ', expansion: null }],
      }),
    ).resolves.toEqual({
      segments: [{ startMs: 0, endMs: 1000, speaker: undefined, text: 'Юридический термин.' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const submitBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(submitBody).toMatchObject({
      uri: 'https://storage.example.test/private-bucket/organizations/org-1/assets/a-1/renditions/v1/speech.ogg',
      recognitionModel: {
        audioFormat: { containerAudio: { containerAudioType: 'OGG_OPUS' } },
        languageRestriction: { languageCode: ['ru-RU'] },
      },
    });
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');
  });

  it('deletes a submitted SpeechKit operation even when polling fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'operation-failed', done: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const adapter = new YandexSpeechKitAdapter(
      {
        apiKey: 'test-api-key-never-logged',
        folderId: 'folder-1',
        recognizeEndpoint: 'https://stt.example.test/recognize',
        operationEndpoint: 'https://stt.example.test/operations',
        resultEndpoint: 'https://stt.example.test/result',
        deleteEndpoint: 'https://stt.example.test/delete',
        audioUriPrefix: 'https://storage.example.test/private/',
        model: 'general',
        pollIntervalMs: 500,
        timeoutSeconds: 60,
      },
      fetchMock,
      async () => undefined,
    );
    await expect(
      adapter.transcribe({
        storageKey: 'speech.ogg',
        language: 'ru-RU',
        durationSeconds: 1,
        dictionary: [],
      }),
    ).rejects.toMatchObject({ code: 'stt_provider_status_failed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1]?.method).toBe('DELETE');
  });

  it('validates structured YandexGPT suggestions and retains the returned model version', async () => {
    const suggestions = {
      suggestions: [
        { type: 'TITLE', orderIndex: 0, content: { text: 'Проверяемое название' } },
        { type: 'CHAPTER', orderIndex: 0, content: { startMs: 0, title: 'Введение' } },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            alternatives: [
              {
                status: 'ALTERNATIVE_STATUS_FINAL',
                message: { role: 'assistant', text: JSON.stringify(suggestions) },
              },
            ],
            modelVersion: '2026-08-01',
          },
        }),
        { status: 200 },
      ),
    );
    const adapter = new YandexFoundationModelsAdapter(
      {
        apiKey: 'test-api-key-never-logged',
        folderId: 'folder-1',
        modelUri: 'gpt://folder-1/yandexgpt/latest',
        endpoint: 'https://llm.example.test/foundationModels/v1/completion',
        timeoutSeconds: 30,
      },
      fetchMock,
    );
    await expect(
      adapter.enrich({
        webinarTitle: 'Договорное право',
        language: 'ru-RU',
        segments: [{ startMs: 0, endMs: 1000, text: 'Текст опубликованной расшифровки.' }],
        dictionary: [],
      }),
    ).resolves.toEqual({ suggestions: suggestions.suggestions, providerModelVersion: '2026-08-01' });
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request).toMatchObject({
      modelUri: 'gpt://folder-1/yandexgpt/latest',
      completionOptions: { stream: false, temperature: 0.1 },
      jsonSchema: { schema: { type: 'object' } },
    });
    expect(request.messages[0].text).toContain('требуют проверки человеком');
  });

  it('fails closed on malformed provider output', async () => {
    const adapter = new YandexFoundationModelsAdapter(
      {
        apiKey: 'test-api-key-never-logged',
        folderId: 'folder-1',
        modelUri: 'gpt://folder/model',
        endpoint: 'https://llm.example.test/completion',
        timeoutSeconds: 30,
      },
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { alternatives: [] } }), { status: 200 })),
    );
    await expect(
      adapter.enrich({
        webinarTitle: 'Тест',
        language: 'ru-RU',
        segments: [{ startMs: 0, endMs: 1_000, text: 'Текст' }],
        dictionary: [],
      }),
    ).rejects.toMatchObject({ code: 'ai_provider_response_invalid' });
  });
});
