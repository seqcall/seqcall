-- :checkhealth seqcall (FR-21.5): what the plugin would use, without starting anything.
local M = {}

function M.check()
  local seqcall = require('seqcall')
  vim.health.start('Seqcall')
  if vim.fn.has('nvim-0.10') == 1 then
    vim.health.ok('Neovim ' .. tostring(vim.version()))
  else
    vim.health.error('Neovim 0.10 or newer is needed')
  end
  local node = seqcall.node(true)
  if node ~= '' then
    vim.health.ok('Node.js: ' .. node .. ' (' .. vim.trim(vim.fn.system({ node, '--version' })) .. ')')
  else
    vim.health.error('Node.js 20 or newer not found', { 'Install Node 20+ or set g:seqcall_node / $SEQCALL_NODE' })
  end
  local sidecar = seqcall.sidecar(true)
  if sidecar ~= '' then
    vim.health.ok('Sidecar: ' .. sidecar)
  else
    vim.health.error('Sidecar stdio-host.cjs not found', { 'Use the packaged plugin (npm run build:vim) or set g:seqcall_sidecar' })
  end
  local csharp = seqcall.csharp_sidecar()
  if csharp == '' then
    vim.health.warn('No C# sidecar: TypeScript/JavaScript and PHP only', { 'Build with npm run build, then npm run build:vim' })
  else
    vim.health.ok('C# sidecar: ' .. csharp)
    local dotnet = seqcall.dotnet()
    if dotnet ~= '' then
      vim.health.ok('dotnet: ' .. dotnet)
    elseif vim.fn.executable('dotnet') == 1 or (vim.env.SEQCALL_DOTNET or '') ~= '' then
      vim.health.ok('dotnet: ' .. (vim.env.SEQCALL_DOTNET or vim.fn.exepath('dotnet')))
    else
      vim.health.warn('dotnet not found: C# projects will fail', { 'Install the .NET runtime or set g:seqcall_dotnet' })
    end
  end
end

return M
