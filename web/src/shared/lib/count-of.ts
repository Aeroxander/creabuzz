/** "1 team", "2 teams": a count with the right form of the word. Give `many` when it is not just `one` plus "s". */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
