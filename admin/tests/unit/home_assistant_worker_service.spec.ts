import { test } from '@japa/runner'
import { HomeAssistantWorkerService } from '#services/home_assistant_worker_service'

test.group('HomeAssistantWorkerService', () => {
  test('ignores trailing filler words in entity references', ({ assert }) => {
    const service = new HomeAssistantWorkerService({} as any)

    const task = service.classify('turn on the porch light oh')

    assert.deepEqual(task, {
      kind: 'call_service',
      domain: 'homeassistant',
      service: 'turn_on',
      data: { entity_ref: 'porch light' },
    })
  })
})
