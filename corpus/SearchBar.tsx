import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function SearchBar() {
  return (
    <div className="flex gap-2">
      <Input type="search" placeholder="Search..." />
      <Button type="submit">Search</Button>
    </div>
  );
}
