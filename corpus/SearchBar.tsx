import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function SearchBar({ onSearch }: { onSearch: (q: string) => void }) {
  const [query, setQuery] = useState("");

  return (
    <div className="flex gap-2">
      <Input type="search" placeholder="Search..." value={query} onChange={(e) => setQuery(e.target.value)} />
      <Button type="submit" onClick={() => onSearch(query)}>Search</Button>
    </div>
  );
}
