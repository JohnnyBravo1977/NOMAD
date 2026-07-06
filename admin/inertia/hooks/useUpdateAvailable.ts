import api from "~/lib/api"
import { CheckLatestVersionResult } from "../../types/system"
import { useQuery } from "@tanstack/react-query"


export const useUpdateAvailable = (enabled: boolean = true) => {
    const queryData = useQuery<CheckLatestVersionResult | undefined>({
        queryKey: ['system-update-available'],
        queryFn: () => api.checkLatestVersion(),
        enabled,
        refetchInterval: Infinity, // Disable automatic refetching
        refetchOnWindowFocus: false,
    })

    return queryData.data
}
