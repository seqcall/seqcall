vim9script
# Seqcall for Vim 9 (FR-21): commands and autocmds, sourced by plugin/seqcall.vim (logic in
# autoload/seqcall.vim). Neovim uses plugin/seqcall.lua instead.

g:loaded_seqcall = 1

import autoload 'seqcall.vim'

command! SeqcallShow seqcall.Show()
command! SeqcallOpen seqcall.ShowView('sequence')
command! SeqcallClass seqcall.ShowView('class')
command! SeqcallEntryPoints seqcall.EntryPoints()
command! SeqcallStop seqcall.Stop()
command! SeqcallLog seqcall.ShowLog()
command! SeqcallUpdate seqcall.Update()
command! SeqcallInfo seqcall.Info()
command! -nargs=? SeqcallReach seqcall.Reach(<q-args>)
command! SeqcallMemory seqcall.Memory()
command! SeqcallFreeMemory seqcall.FreeMemory()

nnoremap <silent> <Plug>(seqcall-show) <ScriptCmd>seqcall.Show()<CR>
nnoremap <silent> <Plug>(seqcall-info) <ScriptCmd>seqcall.Info()<CR>

augroup seqcall
  autocmd!
  autocmd BufWritePost * seqcall.OnWrite(expand('<afile>:p'))
  autocmd CursorMoved * seqcall.OnCursorMoved()
  autocmd VimLeavePre * seqcall.Stop()
augroup END
