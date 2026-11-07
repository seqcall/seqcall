" Seqcall (FR-21): interactive sequence and class diagrams in a browser tab. :help seqcall
" Legacy script on purpose: Neovim sources plugin/*.vim too but has no Vim9 script; it uses
" plugin/seqcall.lua. In Vim the commands live in vim9/commands.vim.
if has('nvim') || exists('g:loaded_seqcall') || !has('patch-9.0.1485')
  finish
endif
execute 'source ' .. fnameescape(expand('<sfile>:p:h:h') .. '/vim9/commands.vim')
