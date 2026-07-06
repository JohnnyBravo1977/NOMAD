/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

if (process.env.NODE_ENV === 'test') {
  process.env.PORT ??= '3333'
  process.env.APP_KEY ??= 'test-app-key-1234567890'
  process.env.HOST ??= '127.0.0.1'
  process.env.URL ??= 'http://127.0.0.1:3333'
  process.env.LOG_LEVEL ??= 'silent'
  process.env.DB_HOST ??= '127.0.0.1'
  process.env.DB_PORT ??= '3306'
  process.env.DB_USER ??= 'nomad_test'
  process.env.DB_DATABASE ??= 'nomad_test'
  process.env.REDIS_HOST ??= '127.0.0.1'
  process.env.REDIS_PORT ??= '6379'
}

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  HOST: Env.schema.string({ format: 'host' }),
  URL: Env.schema.string(),
  LOG_LEVEL: Env.schema.string(),
  INTERNET_STATUS_TEST_URL: Env.schema.string.optional(),
  DISABLE_COMPRESSION: Env.schema.boolean.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring storage paths
  |----------------------------------------------------------
  */
  NOMAD_STORAGE_PATH: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring session package
  |----------------------------------------------------------
  */
  //SESSION_DRIVER: Env.schema.enum(['cookie', 'memory'] as const),

  /*
  |----------------------------------------------------------
  | Variables for configuring the database package
  |----------------------------------------------------------
  */
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),
  DB_SSL: Env.schema.boolean.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring the Redis connection
  |----------------------------------------------------------
  */
  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),

  /*
  |----------------------------------------------------------
  | Variables for configuring Project Nomad's external API URL
  |----------------------------------------------------------
  */
  NOMAD_API_URL: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | AI / Ollama tuning
  |----------------------------------------------------------
  */
  NOMAD_OLLAMA_KEEP_ALIVE: Env.schema.string.optional(),
  NOMAD_OLLAMA_KEEP_ALIVE_MODELS: Env.schema.string.optional(),
  NOMAD_DISABLE_QUERY_REWRITE: Env.schema.boolean.optional(),
  NOMAD_DISABLE_RAG: Env.schema.boolean.optional(),
  NOMAD_RAG_MIN_SCORE: Env.schema.number.optional(),
  NOMAD_RAG_MIN_CHARS: Env.schema.number.optional(),
  NOMAD_HERMES_ROUTER_MODEL: Env.schema.string.optional(),
  NOMAD_OLLAMA_KV_CACHE_TYPE: Env.schema.string.optional(),
  NOMAD_OLLAMA_MAX_QUEUE: Env.schema.string.optional(),
  NOMAD_TIMEZONE: Env.schema.string.optional(),
})
