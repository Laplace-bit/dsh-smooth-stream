import { readFile, writeFile } from 'node:fs/promises'

const repository = process.env.GITHUB_REPOSITORY ?? 'Laplace-bit/dsh-smooth-stream'
const token = process.env.GITHUB_TOKEN

if (!token) throw new Error('GITHUB_TOKEN is required')

const githubHeaders = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'x-github-api-version': '2022-11-28',
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`)
  }
  return response.json()
}

const [repo, views, clones, npm] = await Promise.all([
  fetchJson(`https://api.github.com/repos/${repository}`, githubHeaders),
  fetchJson(`https://api.github.com/repos/${repository}/traffic/views`, githubHeaders),
  fetchJson(`https://api.github.com/repos/${repository}/traffic/clones`, githubHeaders),
  fetchJson('https://api.npmjs.org/downloads/point/last-week/dsh-smooth-stream'),
])

const capturedAt = new Date().toISOString()
const columns = [
  capturedAt,
  repo.stargazers_count,
  repo.forks_count,
  repo.open_issues_count,
  views.count,
  views.uniques,
  clones.count,
  clones.uniques,
  npm.downloads,
  npm.start,
  npm.end,
]
const line = `${columns.join(',')}\n`
const metricsPath = new URL('../growth/metrics.csv', import.meta.url)
const current = await readFile(metricsPath, 'utf8')
const rows = current.trimEnd().split('\n')
const capturedDate = capturedAt.slice(0, 10)
const existingIndex = rows.findIndex((row, index) => index > 0 && row.startsWith(capturedDate))

if (existingIndex === -1) rows.push(line.trimEnd())
else rows[existingIndex] = line.trimEnd()
await writeFile(metricsPath, `${rows.join('\n')}\n`)

console.log(line.trim())
