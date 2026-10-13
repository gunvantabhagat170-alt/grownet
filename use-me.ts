import { useQuery } from "@tanstack/react-query";
import { getMe } from "./server";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => getMe(),
    retry: 1,
    staleTime: 8_000,
    refetchInterval: 15_000,
  });
}
