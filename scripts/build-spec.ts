import { writeFileSync, mkdirSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { processSpec } from '../src/spec-processor'

const SPEC_URL = 'https://api.ynab.com/papi/open_api_spec.yaml'
const OUTPUT_PATH = 'spec/ynab-spec.json'

async function main() {
  console.log(`Fetching YNAB OpenAPI spec from ${SPEC_URL}...`)
  const response = await fetch(SPEC_URL)
  if (!response.ok) {
    console.error(`Failed to fetch spec: ${response.status} ${response.statusText}`)
    process.exit(1)
  }
  const yamlText = await response.text()
  console.log(`Fetched ${yamlText.length} bytes of YAML`)

  const raw = parseYaml(yamlText)
  const processed = processSpec(raw)
  const json = JSON.stringify(processed, null, 2)

  mkdirSync('spec', { recursive: true })
  writeFileSync(OUTPUT_PATH, json)
  console.log(
    `Wrote processed spec to ${OUTPUT_PATH} (${json.length} bytes, ${Object.keys(processed.paths ?? {}).length} paths)`
  )
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
