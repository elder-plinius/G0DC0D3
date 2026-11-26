/* Additional lightweight Highlight.js v11.9.0 language grammars (zero external dependencies). */
(function registerExtraHljsLanguages() {
  if (typeof hljs === 'undefined' || typeof hljs.registerLanguage !== 'function') return;
  const reg = (name, fn) => { try { if (!hljs.getLanguage(name)) hljs.registerLanguage(name, fn); } catch {} };

  reg('toml', e => ({
    name: 'TOML',
    aliases: ['toml'],
    contains: [
      e.HASH_COMMENT_MODE,
      { className: 'section', begin: /^\s*\[+/, end: /\]+/ },
      { className: 'attr', begin: /^\s*[A-Za-z0-9_.-]+(?=\s*=)/ },
      { className: 'literal', begin: /\b(?:true|false)\b/ },
      { className: 'number', begin: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?\b/ },
      e.QUOTE_STRING_MODE,
      e.APOS_STRING_MODE,
      e.C_NUMBER_MODE
    ]
  }));

  reg('zig', e => ({
    name: 'Zig',
    aliases: ['zig'],
    keywords: {
      keyword: 'addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while',
      type: 'bool f16 f32 f64 f80 f128 i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize comptime_int comptime_float anyopaque void noreturn type c_char c_short c_int c_long c_longlong',
      literal: 'true false null undefined'
    },
    contains: [
      e.C_LINE_COMMENT_MODE,
      e.QUOTE_STRING_MODE,
      { className: 'built_in', begin: /@[A-Za-z_]\w*/ },
      e.C_NUMBER_MODE
    ]
  }));

  reg('powershell', e => ({
    name: 'PowerShell',
    aliases: ['ps', 'ps1', 'pwsh'],
    case_insensitive: true,
    keywords: {
      keyword: 'begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using var while workflow',
      literal: '$true $false $null'
    },
    contains: [
      e.HASH_COMMENT_MODE,
      e.COMMENT('<#', '#>'),
      e.QUOTE_STRING_MODE,
      e.APOS_STRING_MODE,
      { className: 'variable', begin: /\$[A-Za-z_][\w:]*/ },
      { className: 'built_in', begin: /\b[A-Za-z]+-[A-Za-z]+\b/ },
      e.C_NUMBER_MODE
    ]
  }));

  reg('elixir', e => ({
    name: 'Elixir',
    aliases: ['ex', 'exs'],
    keywords: {
      keyword: 'and after alias case catch cond def defdelegate defexception defimpl defmacro defmacrop defmodule defoverridable defp defprotocol defstruct do else end fn for if import in not or quote raise receive require rescue super throw try unless unquote use when with',
      literal: 'true false nil'
    },
    contains: [
      e.HASH_COMMENT_MODE,
      e.QUOTE_STRING_MODE,
      { className: 'symbol', begin: /:[A-Za-z_]\w*[!?]?/ },
      { className: 'title.class', begin: /\b[A-Z][A-Za-z0-9_]*\b/ },
      e.C_NUMBER_MODE
    ]
  }));

  reg('haskell', e => ({
    name: 'Haskell',
    aliases: ['hs'],
    keywords: {
      keyword: 'as case class data default deriving do else forall foreign hiding if import in infix infixl infixr instance let module newtype of qualified then type where',
      literal: 'True False Nothing Just Left Right'
    },
    contains: [
      e.COMMENT('--', '$'),
      e.COMMENT('\\{-', '-\\}'),
      e.QUOTE_STRING_MODE,
      { className: 'type', begin: /\b[A-Z][A-Za-z0-9_']*\b/ },
      e.C_NUMBER_MODE
    ]
  }));

  reg('scala', e => ({
    name: 'Scala',
    aliases: ['scala', 'sc'],
    keywords: {
      keyword: 'abstract case catch class def do else enum export extends final finally for given if implicit import lazy match new object override package private protected return sealed super then throw trait try type val var while with yield',
      literal: 'true false null this'
    },
    contains: [
      e.C_LINE_COMMENT_MODE,
      e.C_BLOCK_COMMENT_MODE,
      e.QUOTE_STRING_MODE,
      { className: 'meta', begin: /@[A-Za-z_]\w*/ },
      e.C_NUMBER_MODE
    ]
  }));

  reg('protobuf', e => ({
    name: 'Protocol Buffers',
    aliases: ['proto'],
    keywords: {
      keyword: 'syntax edition package import public weak option message enum service rpc returns oneof map repeated optional required reserved extensions extend to max',
      type: 'double float int32 int64 uint32 uint64 sint32 sint64 fixed32 fixed64 sfixed32 sfixed64 bool string bytes',
      literal: 'true false'
    },
    contains: [e.C_LINE_COMMENT_MODE, e.C_BLOCK_COMMENT_MODE, e.QUOTE_STRING_MODE, e.C_NUMBER_MODE]
  }));

  reg('nix', e => ({
    name: 'Nix',
    aliases: ['nix'],
    keywords: {
      keyword: 'assert else if in inherit let or rec then with',
      literal: 'true false null',
      built_in: 'builtins derivation import map filterAttrs fetchurl fetchGit toString'
    },
    contains: [
      e.HASH_COMMENT_MODE,
      e.C_BLOCK_COMMENT_MODE,
      e.QUOTE_STRING_MODE,
      e.COMMENT("''", "''"),
      e.C_NUMBER_MODE
    ]
  }));

  reg('cmake', e => ({
    name: 'CMake',
    aliases: ['cmake'],
    case_insensitive: true,
    keywords: {
      keyword: 'cmake_minimum_required project add_executable add_library target_link_libraries target_include_directories set option if elseif else endif foreach endforeach function endfunction macro endmacro find_package include install message',
      literal: 'ON OFF TRUE FALSE YES NO'
    },
    contains: [
      e.HASH_COMMENT_MODE,
      e.QUOTE_STRING_MODE,
      { className: 'variable', begin: /\$\{[A-Za-z0-9_]+\}/ },
      e.C_NUMBER_MODE
    ]
  }));

  reg('latex', e => ({
    name: 'LaTeX',
    aliases: ['tex'],
    contains: [
      e.COMMENT('%', '$'),
      { className: 'keyword', begin: /\\[A-Za-z@]+[*]?/ },
      { className: 'formula', begin: /\$\$/, end: /\$\$/ },
      { className: 'formula', begin: /\$/, end: /\$/ }
    ]
  }));

  reg('x86asm', e => ({
    name: 'x86 Assembly',
    aliases: ['asm', 'nasm', 'x86', 'armasm'],
    case_insensitive: true,
    keywords: {
      keyword: 'mov lea push pop call ret jmp je jne jz jnz jg jge jl jle ja jb cmp test add sub inc dec mul imul div idiv and or xor not shl shr sal sar rol ror nop int syscall sysenter leave enter rep movsb stosb ldr str bl bx b beq bne adr adrp svc',
      built_in: 'rax rbx rcx rdx rsi rdi rbp rsp r8 r9 r10 r11 r12 r13 r14 r15 eax ebx ecx edx esi edi ebp esp ax bx cx dx al ah bl bh cl ch dl dh rip eip cs ds es fs gs ss x0 x1 x2 x3 x4 x5 x6 x7 sp lr pc',
      meta: 'section global extern db dw dd dq resb resw resd resq equ byte word dword qword ptr offset .text .data .bss .globl .align'
    },
    contains: [
      e.COMMENT(';', '$'),
      e.HASH_COMMENT_MODE,
      e.QUOTE_STRING_MODE,
      e.APOS_STRING_MODE,
      { className: 'symbol', begin: /^[A-Za-z_.$][\w.$]*:/ },
      { className: 'number', begin: /\b(?:0x[0-9a-fA-F]+|0b[01]+|\d+)\b/ }
    ]
  }));

  reg('solidity', e => ({
    name: 'Solidity',
    aliases: ['sol'],
    keywords: {
      keyword: 'pragma solidity import as contract interface library abstract is struct enum event error modifier function constructor fallback receive public private internal external pure view payable virtual override constant immutable memory calldata storage returns return emit revert require assert if else for while do break continue new delete try catch unchecked assembly using',
      type: 'bool string address bytes uint int uint8 uint16 uint32 uint64 uint128 uint256 int8 int16 int32 int64 int128 int256 bytes1 bytes4 bytes32 mapping',
      literal: 'true false wei gwei ether seconds minutes hours days weeks'
    },
    contains: [e.C_LINE_COMMENT_MODE, e.C_BLOCK_COMMENT_MODE, e.QUOTE_STRING_MODE, e.APOS_STRING_MODE, e.C_NUMBER_MODE]
  }));

  reg('nginx', e => ({
    name: 'Nginx',
    aliases: ['nginxconf'],
    keywords: {
      keyword: 'http server location events stream upstream mail types if return rewrite proxy_pass root index try_files listen server_name ssl_certificate ssl_certificate_key add_header include worker_processes',
      literal: 'on off'
    },
    contains: [
      e.HASH_COMMENT_MODE,
      e.QUOTE_STRING_MODE,
      e.APOS_STRING_MODE,
      { className: 'variable', begin: /\$[A-Za-z_]\w*/ },
      e.C_NUMBER_MODE
    ]
  }));

  reg('hcl', e => ({
    name: 'HCL / Terraform',
    aliases: ['terraform', 'tf', 'tfvars'],
    keywords: {
      keyword: 'resource data variable output locals module provider terraform backend required_providers lifecycle dynamic for_each count depends_on',
      literal: 'true false null'
    },
    contains: [
      e.HASH_COMMENT_MODE,
      e.C_LINE_COMMENT_MODE,
      e.C_BLOCK_COMMENT_MODE,
      e.QUOTE_STRING_MODE,
      e.C_NUMBER_MODE
    ]
  }));

  reg('env', e => ({
    name: 'Dotenv',
    aliases: ['dotenv'],
    contains: [
      e.HASH_COMMENT_MODE,
      { className: 'attr', begin: /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?==)/ },
      e.QUOTE_STRING_MODE,
      e.APOS_STRING_MODE
    ]
  }));
})();
