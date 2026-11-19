import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function UploadCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload</CardTitle>
        <CardDescription>Files up to 10 MB.</CardDescription>
      </CardHeader>
      <CardContent>
        <Label htmlFor="file">File</Label>
        <Input id="file" type="file" />
      </CardContent>
      <CardFooter>
        <Button>Upload</Button>
      </CardFooter>
    </Card>
  );
}
